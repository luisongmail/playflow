-- PlayFlow - Seed de equipos nacionales de prueba
-- Se ejecuta automaticamente en volumenes MySQL nuevos.

INSERT INTO teams (
	id,
	name,
	short_name,
	abbreviation,
	city,
	country,
	primary_color,
	secondary_color,
	active,
	team_code
) VALUES
	('team-argentina', 'Argentina', 'ARG', 'ARG', 'Buenos Aires', 'AR', '#75AADB', '#FFFFFF', 1, 'arg'),
	('team-bolivia', 'Bolivia', 'BOL', 'BOL', 'La Paz', 'BO', '#D52B1E', '#F9E300', 1, 'bol'),
	('team-ecuador', 'Ecuador', 'ECU', 'ECU', 'Quito', 'EC', '#FFD100', '#034EA2', 1, 'ecu')
AS new
ON DUPLICATE KEY UPDATE
	name = new.name,
	short_name = new.short_name,
	abbreviation = new.abbreviation,
	city = new.city,
	country = new.country,
	primary_color = new.primary_color,
	secondary_color = new.secondary_color,
	active = new.active,
	team_code = new.team_code,
	updated_at = CURRENT_TIMESTAMP(3);
